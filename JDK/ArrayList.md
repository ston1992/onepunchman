###Java ArrayList
[详解](https://blog.csdn.net/Sun_flower77/article/details/77170712)  
>jdk1.7构造函数源码：  

   	/*存在两个私有成员，elementData和size*/
    private transient Object[] elementData;
    private int size;
    
    public ArrayList(int initialCapacity) {
        super();
        if (initialCapacity < 0)
            throw new IllegalArgumentException("Illegal Capacity: "+
                                               initialCapacity);
        this.elementData = new Object[initialCapacity];
    }
    
    /**
     * Constructs an empty list with an initial capacity of ten.
     */
    public ArrayList() {
        this(10);
    }


~~~
	public E get(int indewx) {
		rangeCheck(index):
		return elementData(index);
	}
	
	private void rangeCheck(int index) {
		if (index >= size)
			throw new IndexOutOfBoundsException(outOfBoundMsg(index));
	}
	
	E elementData(int index){
		return (E) elementData[index];
	}
~~~
>如何确保空间及伸缩:

~~~
ArrayList<Object> obj = new ArrayList<Object>(20);
~~~

>等价于

~~~
ArrayList<Object> obj = new ArrayList<Object>(20);     
obj.ensureCapacity(20);   
~~~

> ensureCapacity(minCapacity)的源码:

~~~
	public void ensureCpacity(int minCapacity){
		if (minCpacity > 0)
		ensureCpacityInternal(minCpacity);
	}
	
	public void ensureCpacityInternal(int minCapacity) {
		modCount++;
		//Overflow-conscious code
		if (minCpacity - elementData.length > 0)
			grow(minCapacity);
	}
	
	private void grow(int minCpacity) {
		//overflow-conscious code
		int oldCpacity = elementData.length;
		/*jdk1.7之后的容量增长机制是这样的，还有这样计算的：newCapacity = (oldCapacity * 3)/2 + 1;*/
		int newCapacity = oldCapacity + (oldCapacity >> 1);
		if (newCapacity - minCapacity < 0)
			newCapacity = minCapacity;
		if (newCapacity - MAX_ARRAY_SIZE > 0)
			newCapacity = hugeCapacity(minCapacity);
		//minCapacity is usually close to size,so this is a win:
		//先按照指定参数创建一个更大的数组，然后把原来数组一个一个的copy到大数组中，最后将elementData的引用指向这个大数组。这样就增大了数组列表的容量，小数组也会被gc回收。所以数据量很大的时候建议初始化的时候就指定容量，提高效率（数组默认的初始化容量一般是10，根据不同的底层实现而定）
		elementData = Arrays.copyOf(elementData, newCapacity);
	}
~~~
>同样，add方法：

~~~
	public boolean add(E e) {
		ensureCapacityInternal(size +1); //increments modCount!!
		elementData[Size++] = e;
		return true;
	}
	
	private void ensureCapacityInternal(int minCapacity){
		modCount++;
		//overflow-conscious code
		if(minCapacity - elementData.length > 0)
			grow(minCapacity);
	}
	
	private void grow(int minCapacity) {
		//overflow-conscious code
		int oldCapacity = elementData.length;
		int newCapacity = oldCapacity + (oldCapacity >> 1);
		if (newCapacity - minCapacity < 0) //minCapacity是默认的数组列表默认的最小容量
			newCapacity = minCapacity;
		if (newCapacity - MAX_ARRAY_SIZE > 0) //判断容量是否超过最大限制
			newCapacity = hugeCapacity(minCapacity);
		elementData = Arrays.copyOf(elementData, newCapacity);
	}
~~~

>Java ArrayList 与 Array的区别

~~~
ArrayList<Object> array = new ArrayList<>();
Object[] obj = new Object[10];
/*这两个语句都开辟了10个元素空间，一个是数组列表，一个是数组。但是数组有大小，是固定的；数组列表拥有的是容量，并且是可变的。  
数组和数组列表在初始化之后，System.out.println(obj[0]; 可以打印出null，而System.out.println(array.get(0));会报错。ArrayList里的方法都不是同步的，所以当不止一个线程要修改ArrayList实例时，必须让它保持外部同步。可以使用List list = Collections.synchronizedList(new ArrayList(…)); 来防止这一问题发生。)
*/
~~~

>ArrayList不是线程安全的，要保证线程安全，第一种是用synchronized来同步所有的ArrayList操作方法。第二中方法是Copy On Write(COW,在当前县城中得到原始数据的一份拷贝然后进行操作。JDK的一个实现：CopyOnWriteArrayList.)如果不是写少读多的场景，使用CopyOnWriteArrayList开销比较大，因为每次对其更新操作（add/set/remove）都会做一次数组拷贝。[COW](http://ifeve.com/java-copy-on-write/) (链接加星。其实COW也是一种读写分离的思想，读和写在不同的容器。写的时候会加锁，读还是会读到旧的数据，因为写的时候不会锁住旧的ArrayList。COW应用场景：CopyOnWrite并发容器用于读多写少的并发场景。比如白名单，黑名单，商品类目的访问和更新场景，假如我们有一个搜索网站，用户在这个网站的搜索框中，输入关键字搜索内容，但是某些关键字不允许被搜索。这些不能被搜索的关键字会被放在一个黑名单当中，黑名单每天晚上更新一次。当用户搜索时，会检查当前关键字在不在黑名单当中，如果在，则提示不能搜索。)
>使用时注意：减小扩容开销、使用批量添加
>问题：内存占用（压缩元素成36/64进制or使用其他并非容器如ConcurrentHashMap）；数据一致性问题（不能保证数据的实时一致性）

